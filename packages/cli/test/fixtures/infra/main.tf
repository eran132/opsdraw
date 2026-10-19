resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
resource "aws_subnet" "app" {
  vpc_id = aws_vpc.main.id
}
resource "aws_instance" "web" {
  subnet_id = aws_subnet.app.id
}
resource "aws_db_instance" "db" {
  db_subnet_group_name = aws_subnet.app.id
}
